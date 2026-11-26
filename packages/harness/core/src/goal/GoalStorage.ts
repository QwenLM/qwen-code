/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @fileoverview File-based persistence for the current Goal.
 *
 * Goals are session-scoped: each session persists its goal as JSON under
 * `<projectStateDir>/goals/<sessionId>.json`. A session can therefore never
 * see — let alone mutate — another session's goal, which removes the whole
 * cross-session ownership/locking problem by construction. Resuming a session
 * (`--resume <id>`) naturally reattaches to that session's goal file.
 *
 * Uses atomic write (tmp + rename) to prevent corruption on crash.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { type Goal } from './types.js';

/** Keep goal file names filesystem-safe regardless of sessionId format. */
function sanitizeSessionId(sessionId: string): string {
  return sessionId.replace(/[^a-zA-Z0-9._-]/g, '_');
}

export class GoalStorage {
  private filePath: string;
  private cache: Goal | null | undefined = undefined; // undefined = not loaded

  constructor(stateDir: string, sessionId: string) {
    this.filePath = path.join(
      stateDir,
      'goals',
      `${sanitizeSessionId(sessionId)}.json`,
    );
  }

  save(goal: Goal): void {
    try {
      const dir = path.dirname(this.filePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      const tmpPath = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
      fs.writeFileSync(tmpPath, JSON.stringify(goal, null, 2));
      fs.renameSync(tmpPath, this.filePath);
      this.cache = goal;
    } catch {
      // Write failure is non-fatal — keep in-memory state, retry on next save.
      this.cache = goal;
    }
  }

  load(options?: { fresh?: boolean }): Goal | null {
    if (!options?.fresh && this.cache !== undefined) {
      return this.cache;
    }
    try {
      if (fs.existsSync(this.filePath)) {
        const content = fs.readFileSync(this.filePath, 'utf-8');
        this.cache = JSON.parse(content) as Goal;
      } else {
        this.cache = null;
      }
    } catch {
      // Corrupt or unreadable file – treat as absent.
      this.cache = null;
    }
    return this.cache;
  }

  delete(): void {
    try {
      if (fs.existsSync(this.filePath)) {
        fs.unlinkSync(this.filePath);
      }
    } catch {
      // Best-effort removal; ignore errors.
    }
    this.cache = null;
  }
}
