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
    return this.data.tips[tipId]?.lastSessionTimestamp ?? 0;
  }

  /**
   * Record that a tip was shown at the given prompt count.
   */
  recordShown(tipId: string, currentPromptCount: number): void {
    this.sessionShown.set(tipId, currentPromptCount);
    const entry = this.data.tips[tipId];
    if (entry) {
      entry.totalShown++;
      entry.lastSessionTimestamp = Date.now();
    } else {
      this.data.tips[tipId] = {
        totalShown: 1,
        lastSessionTimestamp: Date.now(),
      };
    }
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
      fs.writeFileSync(this.filePath, JSON.stringify(this.data, null, 2));
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
          data = parsed as TipHistoryData;
        }
      }
    } catch {
      // Ignore read/parse errors — start fresh
    }

    // Increment session count for this startup
    data.sessionCount++;
    data.tips = data.tips ?? {};

    const history = new TipHistory(data, filePath);
    history.persist();
    return history;
  }
}
