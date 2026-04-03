/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Tracks files read during an agent session and detects external modifications.
 * Used to notify the model when files it has read are changed by bash commands.
 */
import { createHash } from 'node:crypto';
import { statSync, readFileSync } from 'node:fs';

interface TrackedFile {
  path: string;
  mtime: number;
  contentHash: string;
  lastAccessTurn: number;
}

export class FileTracker {
  private tracked = new Map<string, TrackedFile>();
  private currentTurn = 0;
  private readonly MAX_TURN_AGE = 10;

  setTurn(turn: number): void {
    this.currentTurn = turn;
    // Evict entries not accessed in last MAX_TURN_AGE turns
    for (const [path, entry] of this.tracked) {
      if (this.currentTurn - entry.lastAccessTurn > this.MAX_TURN_AGE) {
        this.tracked.delete(path);
      }
    }
  }

  record(path: string, content: string): void {
    const hash = createHash('sha256').update(content).digest('hex');
    let mtime = 0;
    try {
      mtime = statSync(path).mtimeMs;
    } catch {
      // file may not exist on disk (in-memory)
    }
    this.tracked.set(path, {
      path,
      mtime,
      contentHash: hash,
      lastAccessTurn: this.currentTurn,
    });
  }

  /** Returns paths of files that have been externally modified since last read. */
  getChangedPaths(): string[] {
    const changed: string[] = [];
    for (const [path, entry] of this.tracked) {
      try {
        const stat = statSync(path);
        if (stat.mtimeMs === entry.mtime) continue; // fast path: mtime unchanged
        // mtime changed — verify with hash
        const current = readFileSync(path, 'utf-8');
        const currentHash = createHash('sha256').update(current).digest('hex');
        if (currentHash !== entry.contentHash) {
          changed.push(path);
          // Update stored hash so we don't re-report the same change
          this.tracked.set(path, {
            ...entry,
            mtime: stat.mtimeMs,
            contentHash: currentHash,
          });
        }
      } catch {
        // File deleted or unreadable — remove from tracking
        this.tracked.delete(path);
      }
    }
    return changed;
  }

  clear(): void {
    this.tracked.clear();
  }
}

/** Session-scoped singleton for tracking read files across tool invocations. */
export const sessionFileTracker = new FileTracker();
