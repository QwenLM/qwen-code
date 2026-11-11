/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { readFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import * as path from 'node:path';
import lockfile from 'proper-lockfile';
import { Storage } from '../config/storage.js';
import { writeFileAtomic } from '../utils/fileWriteUtils.js';
import { runLogger } from '../utils/runLogger.js';

interface SkillUsageEntry {
  usageCount: number;
  lastUsedAt: number;
}

/** Local discovery history; lazy I/O, with at most one increment per skill/minute. */
export class SkillUsage {
  private entries?: Record<string, SkillUsageEntry>;
  private readonly lastRecordedAt = new Map<string, number>();

  constructor(
    private readonly filePath = path.join(
      Storage.getGlobalConfigDir(),
      'skill-usage.json',
    ),
  ) {}

  private read(): Record<string, SkillUsageEntry> {
    try {
      const data: unknown = JSON.parse(readFileSync(this.filePath, 'utf8'));
      if (!data || typeof data !== 'object' || Array.isArray(data)) return {};
      return Object.fromEntries(
        Object.entries(data).filter(
          ([, entry]) =>
            entry &&
            Number.isFinite(entry.usageCount) &&
            entry.usageCount >= 0 &&
            Number.isFinite(entry.lastUsedAt),
        ),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        runLogger.debug('[skills] Could not read usage history', error);
      }
      return {};
    }
  }

  getScore(name: string, now = Date.now()): number {
    const entries = (this.entries ??= this.read());
    const entry = Object.hasOwn(entries, name) ? entries[name] : undefined;
    if (!entry) return 0;
    const days = (now - entry.lastUsedAt) / 86_400_000;
    return entry.usageCount * Math.max(0.5 ** (days / 7), 0.1);
  }

  async record(name: string, now = Date.now()): Promise<void> {
    const last = this.lastRecordedAt.get(name);
    if (last !== undefined && now - last < 60_000) return;
    this.lastRecordedAt.set(name, now);
    try {
      await mkdir(path.dirname(this.filePath), { recursive: true });
      const release = await lockfile.lock(this.filePath, {
        realpath: false,
        retries: { retries: 3, minTimeout: 10, maxTimeout: 50 },
      });
      try {
        const entries = this.read();
        this.entries = {
          ...entries,
          [name]: {
            usageCount:
              (Object.hasOwn(entries, name) ? entries[name].usageCount : 0) + 1,
            lastUsedAt: now,
          },
        };
        await writeFileAtomic(this.filePath, JSON.stringify(this.entries));
      } finally {
        await release();
      }
    } catch (error) {
      // Ranking is advisory; a read-only config directory cannot block a skill.
      runLogger.debug('[skills] Could not record usage history', error);
    }
  }
}
